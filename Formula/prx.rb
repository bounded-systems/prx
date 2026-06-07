# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.8.2"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.8.2/prx-aarch64-darwin"
      sha256 "e2ec0084e711f20163c3b32d40b9343c1c286bd3f0c4af7922eea3bca009a7c1"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.8.2/prx-x86_64-linux"
      sha256 "43eab94094299ecfa0ecb455b66eaa09718d84492651b6993b83b7b579432914"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
