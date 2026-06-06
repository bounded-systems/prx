# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.3.1"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.3.1/prx-aarch64-darwin"
      sha256 "c51a3a6cc772ae8ef2de9a4a6384fa780f4dbd966218e64115e52f3fad83c968"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.3.1/prx-x86_64-linux"
      sha256 "ddb70e9e23cb586215e73c6ca04f864c0ff4c8427c2cd36be6134a173765794d"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
