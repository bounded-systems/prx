# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.28.2"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.28.2/prx-aarch64-darwin"
      sha256 "c5b4d2891eca4430b50a28b81ae227ca6ac69ca32a81ddd6fae89b2016961661"
    end
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.28.2/prx-x86_64-darwin"
      sha256 "1c2d4c42eeea7ca177bd947d51dacabe1a0c9c9dda19eef84b68a2c2472b0a05"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.28.2/prx-x86_64-linux"
      sha256 "bacf3764c4032fb118f1b176bfe29721c0a4cd850674d65bc46970c4484bc3a0"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.28.2/prx-aarch64-linux"
      sha256 "9af2cab7956c2403fcff172d29b9e4319cd01519d820634e2c43a5d3e8a07d0f"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
