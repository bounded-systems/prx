# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.3.2"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.3.2/prx-aarch64-darwin"
      sha256 "d8b6ea0437273c6dd48daa64581f2160df260767d40b9b100fdbe23eefb71bca"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.3.2/prx-x86_64-linux"
      sha256 "f2ba1a1034a094af0e48b7fb1c374357d80e60f9029b965005ee0b73ac9ed824"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
