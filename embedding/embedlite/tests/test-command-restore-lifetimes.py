#!/usr/bin/env python3
# Copyright (c) 2026 Jolla Mobile Ltd
# SPDX-License-Identifier: MPL-2.0
"""Exercise production command and restore methods using host lifetime doubles."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1] / 'embedshared'

def method(file, start, end):
    source = (root / file).read_text()
    return source[source.index(start):source.index(end, source.index(start))]

command = method('EmbedLiteChromeSessionChild.cpp',
                 'bool EmbedLiteChromeSessionChild::DispatchContentCommand(',
                 '\nvoid EmbedLiteChromeSessionChild::ReplayContentRegistrations(')
user_agent = method('EmbedLiteChromeSessionChild.cpp',
                    'bool EmbedLiteChromeSessionChild::SetHttpUserAgent(',
                    '\nbool EmbedLiteChromeSessionChild::SetThrottlePainting(')
restore = method('EmbedLiteHostedWindow.cpp',
                 'bool EmbedLiteHostedWindow::RestoreTabs(',
                 '\n}', ) + '\n}\n'
prelude = r'''
#include <cassert>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>
using nsAString = std::u16string;
nsAString operator""_ns(const char16_t* s, size_t n) { return nsAString(s, n); }
template<class T> class RefPtr : public std::shared_ptr<T> {
public:
  using std::shared_ptr<T>::shared_ptr;
  RefPtr(T* t) : std::shared_ptr<T>(t->shared_from_this()) {}
  RefPtr(std::shared_ptr<T> t) : std::shared_ptr<T>(t) {}
};
struct ErrorResult { bool Failed() { return false; } void SuppressException() {} };
struct Event : std::enable_shared_from_this<Event> {
  void InitEvent(const nsAString&, bool, bool) {}
};
enum class CallerType { NonSystem };
namespace dom {
struct Element : std::enable_shared_from_this<Element> {
  std::function<void()> dispatch;
  unsigned cleaned = 0;
  void SetAttribute(const nsAString&, const nsAString&, ErrorResult&) {}
  void RemoveAttribute(const nsAString&, ErrorResult&) { ++cleaned; }
  bool DispatchEvent(Event&, CallerType, ErrorResult&) { if (dispatch) dispatch(); return true; }
};
}
RefPtr<Event> NS_NewDOMEvent(RefPtr<dom::Element>, void*, void*) { return std::make_shared<Event>(); }
template<class T> struct nsTArray : std::vector<T> {
  using std::vector<T>::vector;
  size_t Length() const { return this->size(); }
  void SetCapacity(size_t n) { this->reserve(n); }
  void AppendElement(T value) { this->push_back(std::move(value)); }
};
struct EmbedLiteChromeHistoryData {
  nsAString url, text;
  nsAString& location() { return url; }
  const nsAString& location() const { return url; }
  nsAString& title() { return text; }
  const nsAString& title() const { return text; }
};
struct EmbedLiteChromeTabRestoreData {
  uint64_t id = 7; int32_t selected = 0;
  nsTArray<EmbedLiteChromeHistoryData> entries;
  uint64_t& persistentId() { return id; }
  uint64_t persistentId() const { return id; }
  int32_t& selectedHistoryIndex() { return selected; }
  int32_t selectedHistoryIndex() const { return selected; }
  auto& history() { return entries; }
  const auto& history() const { return entries; }
};
class EmbedLiteChromeSessionChild : public std::enable_shared_from_this<EmbedLiteChromeSessionChild> {
public:
  struct TabRecord {
    RefPtr<dom::Element> browser = std::make_shared<dom::Element>();
    bool crashed = false, discarded = false, restoring = false, hasHttpUserAgent = false;
    nsAString httpUserAgent;
  };
  std::unique_ptr<TabRecord> record = std::make_unique<TabRecord>();
  bool mShuttingDown = false;
  TabRecord* FindTab(uint64_t id) { return id == 7 ? record.get() : nullptr; }
  bool DispatchContentCommand(TabRecord&, const nsAString&, const nsAString&);
  bool SetHttpUserAgent(uint64_t, const nsAString&);
  std::function<void()> restoring;
  unsigned restores = 0;
  bool RestoreTabs(const nsTArray<EmbedLiteChromeTabRestoreData>&, int32_t selected) {
    ++restores;
    if (restoring) restoring();
    return selected == 0;
  }
};
class EmbedLiteHostedWindow : public std::enable_shared_from_this<EmbedLiteHostedWindow> {
public:
  bool mDestroying = false, mRestoreTabsReceived = false;
  RefPtr<EmbedLiteChromeSessionChild> mChromeSession;
  nsTArray<EmbedLiteChromeTabRestoreData> mPendingRestoreTabs;
  int32_t mPendingSelectedTabIndex = -1;
  bool RestoreTabs(const nsTArray<EmbedLiteChromeTabRestoreData>&, int32_t);
};
'''
main = r'''
int main() {
  for (int state = 0; state < 6; ++state) {
    auto session = std::make_shared<EmbedLiteChromeSessionChild>();
    if (state == 0) session->record.reset();
    if (state == 1) session->record->browser.reset();
    if (state == 2) session->record->crashed = true;
    if (state == 3) session->record->discarded = true;
    if (state == 4) session->record->restoring = true;
    if (state == 5) session->mShuttingDown = true;
    assert(!session->SetHttpUserAgent(7, u"custom"));
  }
  for (int action = 0; action < 4; ++action) {
    auto session = std::make_shared<EmbedLiteChromeSessionChild>();
    auto browser = session->record->browser;
    browser->dispatch = [&] {
      if (action == 1) session->record.reset();
      if (action == 2) session->record->browser = std::make_shared<dom::Element>();
      if (action == 3) session->mShuttingDown = true;
    };
    assert(session->SetHttpUserAgent(7, u"custom") == (action == 0));
    assert(browser->cleaned == 3);
    if (session->record) assert(session->record->hasHttpUserAgent == (action == 0));
  }
  // Drop every external owner during dispatch; production methods must keep
  // both session and browser alive until cleanup finishes.
  auto session = std::make_shared<EmbedLiteChromeSessionChild>();
  std::weak_ptr<EmbedLiteChromeSessionChild> weakSession = session;
  std::weak_ptr<dom::Element> weakBrowser = session->record->browser;
  session->record->browser->dispatch = [&] { session->record.reset(); session.reset(); };
  assert(!session->SetHttpUserAgent(7, u"custom"));
  assert(weakSession.expired() && weakBrowser.expired());

  nsTArray<EmbedLiteChromeTabRestoreData> tabs(1);
  tabs[0].history().AppendElement({u"https://example.org", u"Saved"});
  auto window = std::make_shared<EmbedLiteHostedWindow>();
  window->mChromeSession = std::make_shared<EmbedLiteChromeSessionChild>();
  window->mChromeSession->restoring = [&] {
    assert(!window->RestoreTabs(tabs, 0)); // Reject synchronous duplicate.
  };
  assert(!window->RestoreTabs(tabs, -1));
  assert(!window->mRestoreTabsReceived);
  assert(window->RestoreTabs(tabs, 0)); // Rejected request must permit retry.
  assert(!window->RestoreTabs(tabs, 0));
  assert(window->mChromeSession->restores == 2);
  auto queued = std::make_shared<EmbedLiteHostedWindow>();
  assert(queued->RestoreTabs(tabs, 0));
  assert(queued->mPendingRestoreTabs.size() == 1);
  assert(queued->mPendingRestoreTabs[0].history()[0].location() == u"https://example.org");
  assert(!queued->RestoreTabs(tabs, 0));

  auto destroyed = std::make_shared<EmbedLiteHostedWindow>();
  destroyed->mChromeSession = std::make_shared<EmbedLiteChromeSessionChild>();
  std::weak_ptr<EmbedLiteHostedWindow> weakWindow = destroyed;
  std::weak_ptr<EmbedLiteChromeSessionChild> weakRestore = destroyed->mChromeSession;
  destroyed->mChromeSession->restoring = [&] {
    destroyed->mChromeSession.reset(); destroyed.reset();
  };
  assert(!destroyed->RestoreTabs(tabs, -1));
  assert(weakWindow.expired() && weakRestore.expired());
}
'''
with tempfile.TemporaryDirectory(prefix='embedlite-command-restore-') as directory:
    cpp = Path(directory) / 'test.cpp'
    cpp.write_text(prelude + command + user_agent + restore + main)
    binary = Path(directory) / 'test'
    subprocess.run(['g++', '-std=c++17', '-fsanitize=address,undefined',
                    '-fno-sanitize-recover=all', str(cpp), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('Unavailable/reentrant user-agent commands and rejected/reentrant restore tests passed')
