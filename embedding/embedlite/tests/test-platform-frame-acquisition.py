#!/usr/bin/env python3
# Copyright (c) 2026 Jolla Mobile Ltd
# SPDX-License-Identifier: MPL-2.0
"""Run production frame selection/publication/release with host GL test doubles.

This tests ownership and locking, not EGL driver synchronization or rendering.
"""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
source = (root / 'embedding/embedlite/embedshared/EmbedLiteCompositorBridgeParent.cpp').read_text()
header = (root / 'embedding/embedlite/EmbedLiteWindow.h').read_text()
bridge = (root / 'embedding/embedlite/embedshared/EmbedLiteCompositorBridgeParent.h').read_text()
types = header[header.index('enum class PlatformImageHandleType'):header.index('class EmbedLitePlatformFrameListener')]
records = bridge[bridge.index('  enum class PlatformFrameState'):bridge.index('  bool AcquirePlatformFrameInternal')]
methods = source[source.index('bool\nEmbedLiteCompositorBridgeParent::AcquirePlatformFrame('):source.index('bool\nEmbedLiteCompositorBridgeParent::SetPlatformFrameDeliveryEnabled(')]
# Compile the actual publication branch as well, so superseding policy is not
# independently reimplemented in the test.
start = source.index('    if (mPlatformFrameDeliveryEnabled && hasDescriptor) {')
end = source.index('\n  }\n  if (aToken)', start)
publish = source[start:end]
prelude = r'''
#include <cassert>
#include <cstdint>
#include <functional>
#include <future>
#include <list>
#include <memory>
#include <mutex>
#include <thread>
#define LOGT(...) ((void)0)
#define MOZ_RELEASE_ASSERT(x) assert(x)
using MutexAutoLock = std::lock_guard<std::mutex>;
template<class T> using RefPtr = std::shared_ptr<T>;
namespace mozilla { namespace gl {
struct GLContext {};
enum class SharedSurfaceType { EGLImageShare };
enum class ConsumerFenceStatus { Invalid, Signaled };
using EGLSync = void*;
struct SharedSurface {
  struct { SharedSurfaceType type = SharedSurfaceType::EGLImageShare; } mDesc;
  std::function<void()> acquire;
  int reads = 0;
  void ProducerReadAcquire() { ++reads; if (acquire) acquire(); }
  void ProducerReadRelease() { --reads; }
  virtual ~SharedSurface() = default;
};
struct SharedSurface_EGLImage : SharedSurface {
  ConsumerFenceStatus GetConsumerFenceStatus(EGLSync) { return ConsumerFenceStatus::Signaled; }
};
}}
using namespace mozilla::gl;
'''
fixture = r'''
class EmbedLiteCompositorBridgeParent {
public:
RECORDS
  std::mutex mPlatformImageCallbackMutex, mPlatformImageMutex, mRenderMutex;
  std::list<PlatformFrameRecord> mPlatformFrames;
  PlatformFrameToken mLatestPlatformFrameToken = {0, 0};
  uint64_t mPlatformImageGeneration = 1, mNextPlatformFrameSequence = 0;
  bool mPlatformFrameDeliveryEnabled = true;
  int retirements = 0;
  bool SchedulePlatformFrameRetirement() { ++retirements; return true; }
  bool AcquirePlatformFrame(const PlatformFrameToken&, const PlatformFrameCallback&);
  bool AcquireLatestPlatformFrame(uint64_t, const PlatformFrameCallback&);
  bool AcquirePlatformFrameInternal(const PlatformFrameToken&, bool, const PlatformFrameCallback&);
  bool ReleasePlatformFrame(const PlatformFrameRelease&);
  PlatformFrameToken Publish(std::shared_ptr<SharedSurface> frontBuffer = std::make_shared<SharedSurface_EGLImage>()) {
    MutexAutoLock imageLock(mPlatformImageMutex);
    auto context = std::make_shared<GLContext>();
    PlatformImageDescriptor descriptor = {};
    auto releaseFenceHandleType = PlatformFrameFenceHandleType::EGLSync;
    bool hasDescriptor = true;
    PlatformFrameToken token = {};
PUBLISH
    return token;
  }
  PlatformFrameState State(PlatformFrameToken token) {
    MutexAutoLock imageLock(mPlatformImageMutex);
    for (auto& frame : mPlatformFrames) if (frame.token == token) return frame.state;
    assert(false); return PlatformFrameState::Released;
  }
};
'''.replace('RECORDS', records).replace('PUBLISH', publish)
main = r'''
int main() {
  using Bridge = EmbedLiteCompositorBridgeParent;
  using State = Bridge::PlatformFrameState;
  const auto accept = [](const PlatformFrameDescriptor&) { return true; };
  const auto release = [](Bridge& b, PlatformFrameToken token) {
    return b.ReleasePlatformFrame({token, PlatformFrameFenceHandleType::NoHandle, nullptr});
  };
  {
    Bridge b;
    auto notified = b.Publish();
    auto newest = b.Publish();
    int calls = 0;
    assert(!b.AcquirePlatformFrame(notified, [&](auto&) { ++calls; return true; }));
    PlatformFrameToken acquired = {};
    assert(b.AcquireLatestPlatformFrame(notified.epoch, [&](auto& frame) {
      ++calls; acquired = frame.token; return true;
    }));
    assert(calls == 1 && acquired == newest);
    assert(!release(b, notified));
    assert(release(b, acquired));
    assert(!release(b, acquired));
    assert(b.retirements == 1);
  }
  {
    Bridge b;
    auto exact = b.Publish();
    assert(b.AcquirePlatformFrame(exact, accept));
    assert(release(b, exact));
    assert(!b.AcquireLatestPlatformFrame(0, accept));
    b.Publish();
    assert(!b.AcquireLatestPlatformFrame(2, accept));
    assert(!b.AcquireLatestPlatformFrame(1, {}));
    b.mPlatformFrameDeliveryEnabled = false;
    assert(!b.AcquireLatestPlatformFrame(1, accept));
    b.mPlatformFrameDeliveryEnabled = true;
    ++b.mPlatformImageGeneration;
    auto nextEpoch = b.Publish();
    assert(!b.AcquireLatestPlatformFrame(1, accept));
    assert(b.AcquireLatestPlatformFrame(nextEpoch.epoch, accept));
  }
  // Deterministically publish while acquisition waits for its producer fence.
  // The publisher must run without waiting for the acquiring callback, and the
  // selected image must remain pinned even though the latest token changes.
  for (bool accepted : {false, true}) {
    Bridge b;
    std::promise<void> waiting, resume;
    auto resumed = resume.get_future();
    auto surface = std::make_shared<SharedSurface_EGLImage>();
    surface->acquire = [&] { waiting.set_value(); resumed.wait(); };
    auto selected = b.Publish(surface);
    auto acquisition = std::async(std::launch::async, [&] {
      return b.AcquireLatestPlatformFrame(1, [&](auto& frame) {
        assert(frame.token == selected); return accepted;
      });
    });
    waiting.get_future().wait();
    assert(b.State(selected) == State::Acquiring);
    auto newer = b.Publish();
    assert(b.State(selected) == State::Acquiring);
    resume.set_value();
    assert(acquisition.get() == accepted);
    assert(surface->reads == 0);
    assert(b.State(selected) == (accepted ? State::Acquired : State::Released));
    assert(b.State(newer) == State::Ready);
    if (accepted) assert(release(b, selected));
    assert(b.retirements == 1);
  }
  {
    Bridge b;
    auto token = b.Publish();
    assert(!b.AcquireLatestPlatformFrame(1, [](auto&) { return false; }));
    assert(b.State(token) == State::Ready);
    assert(b.retirements == 0);
    assert(b.AcquireLatestPlatformFrame(1, accept));
    auto second = b.Publish();
    assert(b.AcquireLatestPlatformFrame(1, accept));
    b.Publish();
    assert(!b.AcquireLatestPlatformFrame(1, accept));
    // Released but not retired still consumes the existing lease budget.
    assert(release(b, token));
    assert(!b.AcquireLatestPlatformFrame(1, accept));
    b.mPlatformFrames.pop_front(); // simulate render-thread retirement
    assert(b.AcquireLatestPlatformFrame(1, accept));
    assert(release(b, second));
  }
}
'''
with tempfile.TemporaryDirectory(prefix='embedlite-frame-acquisition-') as directory:
    cpp = Path(directory) / 'test.cpp'
    cpp.write_text(prelude + types + fixture + methods + main)
    binary = Path(directory) / 'test'
    subprocess.run(['g++', '-std=c++17', '-pthread', '-Wall', '-Wextra', '-Werror',
                    '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
                    str(cpp), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=20)
print('Atomic latest-frame acquisition, exact tokens, epochs and lease ownership passed')
