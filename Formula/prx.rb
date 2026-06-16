# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.11.1"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.11.1/prx-aarch64-darwin"
      sha256 "ab52e3f64d1ef02a6828afec08572c7e31f7f3a83b34ceea039ed9e62090ee32"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.11.1/prx-x86_64-linux"
      sha256 "350866c21fa34bb7ad11949105c1bdd24e04ffef46a144a92783a0950a8ec899"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.11.1/prx-aarch64-linux"
      sha256 "2d55d2c4b0a5981dd19e0640c9bae2f6ed930aedb4389e814c5c271e198a4684"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
