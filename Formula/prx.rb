# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.15.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.15.0/prx-aarch64-darwin"
      sha256 "d64e52b834f0f715a331369edf6cd047ed6fde8acde90f955b623b7bd650ebc8"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.15.0/prx-x86_64-linux"
      sha256 "c696c8ae2988b30fc7a95a7cdd1094167ea3514276002981d3a0e18dc00cf0ac"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.15.0/prx-aarch64-linux"
      sha256 "430434338b712d193085e0b0d14cc74485fbb2a8a26734d259a7681aaea4b2c4"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
