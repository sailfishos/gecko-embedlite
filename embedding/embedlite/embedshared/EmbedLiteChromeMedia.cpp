/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "EmbedLiteChromeSessionChild.h"
#include "EmbedLiteHostedWindow.h"
#include "mozilla/dom/CanonicalBrowsingContext.h"
#include "mozilla/dom/MediaControlService.h"
#include "mozilla/dom/MediaController.h"
#include "nsThreadUtils.h"
#include <cmath>

namespace mozilla::embedlite {
using namespace mozilla::dom;
namespace {
uint64_t NextMediaToken()
{
  static uint64_t token = 0; // All hosted sessions run on the main thread.
  MOZ_RELEASE_ASSERT(++token);
  return token;
}
uint64_t MainControllerId()
{
  RefPtr<MediaControlService> service = MediaControlService::GetService();
  MediaController* controller = service ? service->GetMainController() : nullptr;
  return controller ? controller->Id() : 0;
}
const char16_t* const kMediaEvents[] = {
  u"activated", u"deactivated", u"playbackstatechange", u"metadatachange",
  u"supportedkeyschange", u"positionstatechange"
};
uint32_t Capabilities(MediaController* aController)
{
  uint32_t result = 0;
  for (MediaControlKey key : aController->GetSupportedMediaKeys()) {
    EmbedLiteMediaCommand command;
    switch (key) {
      case MediaControlKey::Play: command = EmbedLiteMediaCommand::Play; break;
      case MediaControlKey::Pause: command = EmbedLiteMediaCommand::Pause; break;
      case MediaControlKey::Playpause: command = EmbedLiteMediaCommand::PlayPause; break;
      case MediaControlKey::Stop: command = EmbedLiteMediaCommand::Stop; break;
      case MediaControlKey::Nexttrack: command = EmbedLiteMediaCommand::Next; break;
      case MediaControlKey::Previoustrack: command = EmbedLiteMediaCommand::Previous; break;
      case MediaControlKey::Seekto: command = EmbedLiteMediaCommand::Seek; break;
      default: continue;
    }
    result |= 1u << uint8_t(command);
  }
  return result;
}
}

bool EmbedLiteChromeSessionChild::RetainMedia(const TabRecord& aTab) const
{
  // Native eligibility includes the paused-controller lifetime, allowing Play
  // to reach a paused background document. Rendering remains presentation-only.
  return mBackgroundMediaEnabled && !aTab.crashed && !aTab.discarded &&
    !aTab.mediaDocumentPending && aTab.mediaActive;
}

void EmbedLiteChromeSessionChild::BindMediaController(TabRecord& aTab)
{
  BrowsingContext* context = BrowsingContextFor(aTab);
  RefPtr<MediaController> controller = context
    ? context->Top()->Canonical()->GetMediaController()
    : nullptr;
  if (controller == aTab.mediaController) {
    return;
  }
  DetachMediaController(aTab);
  aTab.mediaController = controller;
  if (!controller) {
    return;
  }
  aTab.controllerToken = NextMediaToken();
  aTab.trackToken = NextMediaToken();
  for (const char16_t* event : kMediaEvents) {
    MOZ_ALWAYS_SUCCEEDS(controller->AddEventListener(
      nsDependentString(event), this, false));
  }
  UpdateMediaState(aTab);
}

void EmbedLiteChromeSessionChild::DetachMediaController(TabRecord& aTab)
{
  if (aTab.mediaController) {
    for (const char16_t* event : kMediaEvents) {
      aTab.mediaController->RemoveEventListener(
        nsDependentString(event), this, false);
    }
  }
  aTab.mediaController = nullptr;
  aTab.controllerToken = aTab.trackToken = 0;
  aTab.mediaPlaying = aTab.mediaActive = false;
  ScheduleTabSnapshot();
  ScheduleMediaStates();
}

void EmbedLiteChromeSessionChild::UpdateMediaState(
    TabRecord& aTab, bool aMetadataChanged)
{
  const bool retained = RetainMedia(aTab);
  const bool playing = !aTab.mediaDocumentPending && aTab.mediaController && aTab.mediaController->IsActive()
    && aTab.mediaController->IsPlaying();
  if (playing != aTab.mediaPlaying) {
    aTab.mediaPlaying = playing;
    ScheduleTabSnapshot();
  }
  aTab.mediaActive = !aTab.mediaDocumentPending && aTab.mediaController && aTab.mediaController->IsActive();
  if (aMetadataChanged) {
    aTab.trackToken = NextMediaToken();
  }
  ApplyTabActiveState(aTab, aTab.id == mSelectedTabId);
  if (retained != RetainMedia(aTab) && aTab.timeoutsSuspended) {
    DispatchContentCommand(aTab, RetainMedia(aTab)
      ? u"resume-timeouts"_ns : u"suspend-timeouts"_ns, u"{}"_ns);
  }
  ScheduleMediaStates();
}

void EmbedLiteChromeSessionChild::ScheduleMediaStates()
{
  if (mMediaStatePending || mShuttingDown) {
    return;
  }
  mMediaStatePending = true;
  NS_DispatchToMainThread(NS_NewRunnableFunction("EmbedLite::MediaStates",
    [self = RefPtr<EmbedLiteChromeSessionChild>(this)]() {
      self->mMediaStatePending = false;
      self->SendMediaStates();
    }));
}

void EmbedLiteChromeSessionChild::SendMediaState(const TabRecord& aTab)
{
  EmbedLiteMediaState state;
  state.tabId = aTab.id;
  state.locationRevision = aTab.locationRevision;
  state.mainControllerId = MainControllerId();
  state.privateBrowsing = mWindow->mPrivateBrowsing;
  RefPtr<MediaController> controller = aTab.mediaController;
  MediaMetadataBase metadata;
  if (controller) {
    state.controllerId = controller->Id();
    state.controllerToken = aTab.controllerToken;
    state.trackToken = aTab.trackToken;
    state.active = !aTab.mediaDocumentPending && controller->IsActive() && !aTab.crashed && !aTab.discarded;
    state.playing = state.active && controller->IsPlaying();
    if (state.active) {
      metadata = controller->GetCurrentMediaMetadata();
      state.title = metadata.mTitle.get();
      state.artist = metadata.mArtist.get();
      state.album = metadata.mAlbum.get();
      state.capabilities = Capabilities(controller);
      if (auto position = controller->GetCurrentPositionState()) {
        state.hasPosition = true;
        state.duration = position->mDuration;
        state.position = position->CurrentPlaybackPosition();
        state.playbackRate = state.playing ? position->mPlaybackRate : 0;
      }
    }
  }
  mWindow->OnMediaStateChanged(state);
}

void EmbedLiteChromeSessionChild::SendMediaStates()
{
  RefPtr<EmbedLiteChromeSessionChild> self(this);
  if (!mWindow || mShuttingDown) {
    return;
  }
  // Publish selection even for an empty session or a controller outside it.
  EmbedLiteMediaState selection;
  selection.mainControllerId = MainControllerId();
  mWindow->OnMediaStateChanged(selection);
  nsTArray<uint64_t> ids;
  for (const auto& tab : mTabs) ids.AppendElement(tab->id);
  for (uint64_t id : ids) {
    if (!mWindow || mShuttingDown) {
      break;
    }
    if (TabRecord* tab = FindTab(id)) {
      SendMediaState(*tab);
    }
  }
}

bool EmbedLiteChromeSessionChild::SetBackgroundMediaEnabled(bool aEnabled)
{
  RefPtr<EmbedLiteChromeSessionChild> self(this);
  mBackgroundMediaEnabled = aEnabled;
  ApplyActiveState();
  nsTArray<uint64_t> ids;
  for (const auto& tab : mTabs) ids.AppendElement(tab->id);
  for (uint64_t id : ids) {
    if (TabRecord* tab = FindTab(id)) {
      if (tab->timeoutsSuspended) {
        DispatchContentCommand(*tab,
          RetainMedia(*tab)
            ? u"resume-timeouts"_ns
            : u"suspend-timeouts"_ns, u"{}"_ns);
      }
    }
  }
  return !mShuttingDown;
}

bool EmbedLiteChromeSessionChild::MediaCommand(uint64_t aTabId,
    uint64_t aControllerToken, uint64_t aTrackToken,
    EmbedLiteMediaCommand aCommand, double aPosition)
{
  TabRecord* tab = FindTab(aTabId);
  RefPtr<MediaController> controller = tab ? tab->mediaController : nullptr;
  if (uint8_t(aCommand) > uint8_t(EmbedLiteMediaCommand::Seek)) {
    return false;
  }
  if (!controller || mShuttingDown || tab->crashed || tab->discarded || tab->mediaDocumentPending ||
      tab->controllerToken != aControllerToken || !controller->IsActive() ||
      controller->Id() != MainControllerId() ||
      !(Capabilities(controller) & (1u << uint8_t(aCommand)))) {
    return false;
  }
  if (aCommand == EmbedLiteMediaCommand::Seek) {
    auto state = controller->GetCurrentPositionState();
    if (tab->trackToken != aTrackToken || !state || !std::isfinite(aPosition) ||
        aPosition < 0 || aPosition > state->mDuration) {
      return false;
    }
  }
  switch (aCommand) {
    case EmbedLiteMediaCommand::Play: controller->Play(); break;
    case EmbedLiteMediaCommand::Pause: controller->Pause(); break;
    case EmbedLiteMediaCommand::PlayPause:
      if (controller->IsPlaying()) {
        controller->Pause();
      } else {
        controller->Play();
      }
      break;
    case EmbedLiteMediaCommand::Stop: controller->Stop(); break;
    case EmbedLiteMediaCommand::Next: controller->NextTrack(); break;
    case EmbedLiteMediaCommand::Previous: controller->PrevTrack(); break;
    case EmbedLiteMediaCommand::Seek: controller->SeekTo(aPosition, false); break;
  }
  return true;
}
} // namespace mozilla::embedlite
