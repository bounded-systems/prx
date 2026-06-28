# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.17.1"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.17.1/prx-aarch64-darwin"
      sha256 "6ca62351d48b3adef9c0fb8c5a70bd987008b73725cbee01934560da31f50eca"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.17.1/prx-x86_64-linux"
      sha256 "721e3d03900cfbaf6a66329cdc636e19d2121033e5f76f9a64bd74ba75e4bf03"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.17.1/prx-aarch64-linux"
      sha256 "3e864414f12df0ba2d3703c55ff174d905fd0a1af755de2f0de2548bc8ba6697"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
