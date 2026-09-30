#!/usr/bin/env python3
# Copyright (c) 2026 Jolla Mobile Ltd
# SPDX-License-Identifier: MPL-2.0
"""Compile production callback/camera/theme code with small host test doubles."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
source = (root / 'embedding/embedlite/embedshared/EmbedLiteChromeSessionChild.cpp').read_text()
message = source[source.index('bool EmbedLiteChromeSessionChild::SendContentMessageToEmbedder('):]
message = message[:message.index('\nbool EmbedLiteChromeSessionChild::ScrollTo(')]
close = source[source.index('    if (!tab->restoring) {', source.index('type.EqualsLiteral("DOMWindowClose")')):]
close = close[:close.index('\n  } else if')]
camera = (root / 'gecko-dev/third_party/libwebrtc/modules/video_capture/sfos/video_capture_sfos.cc').read_text()
wrap = camera[camera.index('buffer = WrapI420Buffer('):]
wrap = wrap[:wrap.index(';') + 1]
look = (root / 'gecko-dev/widget/nsXPLookAndFeel.cpp').read_text()
look = look[look.index('nsresult nsXPLookAndFeel::GetIntValue('):]
look = look[:look.index('\nnsresult nsXPLookAndFeel::GetFloatValue(')]
header = root / 'embedding/embedlite/embedshared/EmbedLiteChromeContentEventOrder.h'
prelude = r'''
#include <cassert>
#include <functional>
#include <memory>
#include <string>
#include <cstdint>
#include "HEADER"
using namespace mozilla::embedlite;
struct nsAString : std::string { using std::string::string; unsigned Length() const { return size(); } };
using nsString = nsAString;
template<class T> struct RefPtr { std::shared_ptr<T> ptr; RefPtr(T* t): ptr(t->shared_from_this()) {} };
struct Window {
  std::function<void()> closed;
  int messages = 0;
  bool OnContentAsyncMessage(uint64_t, uint64_t, uint64_t, nsString, nsString) { ++messages; return true; }
  void OnContentWindowCloseRequested(uint64_t, uint64_t) { if (closed) closed(); }
};
class EmbedLiteChromeSessionChild : public std::enable_shared_from_this<EmbedLiteChromeSessionChild> {
public:
  struct TabRecord { uint64_t id = 1, persistentId = 7, locationRevision = 11; bool restoring = false; };
  std::unique_ptr<TabRecord> record = std::make_unique<TabRecord>();
  Window* mWindow;
  bool mTabSnapshotPending = true;
  std::function<void()> snapshot;
  TabRecord* FindTab(uint64_t id) { return record && record->id == id ? record.get() : nullptr; }
  void RemoveTab(uint64_t id) { if (FindTab(id)) record.reset(); }
  void SendTabSnapshot() { if (snapshot) snapshot(); }
  bool SendContentMessageToEmbedder(uint64_t, const nsAString&, const nsAString&);
  void Close() { auto* tab = record.get(); CLOSE }
};
struct Frame { int width = 640, height = 480, yStride = 640, cStride = 320; const char *y = "y", *cb = "u", *cr = "v"; };
std::function<void()> WrapI420Buffer(int w, int h, const char *y, int ys, const char *u, int us, const char *v, int vs, std::function<void()> lifetime) {
  assert(w == 640 && h == 480 && y && u && v && ys == 640 && us == 320 && vs == 320);
  return lifetime;
}
using nsresult = int;
constexpr int NS_OK = 0, NS_ERROR_FAILURE = 1;
#define NS_SUCCEEDED(x) ((x) == NS_OK)
#define NS_FAILED(x) ((x) != NS_OK)
enum class IntID { SystemUsesDarkTheme, Other };
const char* sIntPrefs[] = {"theme", "other"};
struct Preferences { static inline int value = -1; static int GetInt(const char*, int32_t* result) { *result = value; return value < 0 ? NS_ERROR_FAILURE : NS_OK; } };
struct nsXPLookAndFeel {
  bool dark = false;
  int NativeGetInt(IntID, int32_t& result) { result = dark ? 1 : 0; return NS_OK; }
  nsresult GetIntValue(IntID, int32_t&);
};
'''.replace('HEADER', str(header)).replace('CLOSE', close)
main = r'''
int main() {
  for (int action = 0; action < 4; ++action) {
    Window w;
    auto session = std::make_shared<EmbedLiteChromeSessionChild>();
    session->mWindow = &w;
    session->snapshot = [&] {
      if (action == 1) session->record.reset();
      if (action == 2) session->record->locationRevision++;
      if (action == 3) session->mWindow = nullptr;
    };
    const bool delivered = session->SendContentMessageToEmbedder(1, "message", "{}");
    assert(delivered == (action == 0));
    assert(w.messages == (action == 0 ? 1 : 0));
  }
  for (bool fromSnapshot : {false, true}) {
    Window w;
    auto session = std::make_shared<EmbedLiteChromeSessionChild>();
    session->mWindow = &w;
    if (fromSnapshot) session->snapshot = [&] { session->record.reset(); session->mWindow = nullptr; };
    else w.closed = [&] { session->record.reset(); };
    session->Close();
    assert(!session->record);
  }
  std::function<void()> buffer;
  std::weak_ptr<Frame> retained;
  {
    auto frame = std::make_shared<Frame>();
    retained = frame;
    WRAP
  }
  assert(!retained.expired());
  buffer = {};
  assert(retained.expired());
  nsXPLookAndFeel look;
  for (bool dark : {false, true}) {
    look.dark = dark;
    for (int pref : {-1, 0, 1, 2}) {
      Preferences::value = pref;
      int32_t value;
      assert(look.GetIntValue(IntID::SystemUsesDarkTheme, value) == NS_OK);
      assert(value == ((pref == -1 || pref == 2) ? int(dark) : pref));
    }
  }
  Preferences::value = 2;
  int32_t other;
  look.GetIntValue(IntID::Other, other);
  assert(other == 2);
}
'''.replace('WRAP', wrap)
with tempfile.TemporaryDirectory(prefix='embedlite-review-') as directory:
    cpp = Path(directory) / 'test.cpp'
    cpp.write_text(prelude + message + look + main)
    binary = Path(directory) / 'test'
    subprocess.run(['g++', '-std=c++17', '-fsanitize=address,undefined',
                    '-fno-sanitize-recover=all', str(cpp), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('Reentrant tab callbacks, camera lifetime and ambience fallback passed')
