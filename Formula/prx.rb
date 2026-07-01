# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.26.3"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.3/prx-aarch64-darwin"
      sha256 "a6bdb82dd5fc6c6d6e369f7d13f0524f3c8c506062ff24eebb3ad129187408ca"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.3/prx-x86_64-linux"
      sha256 "a7fed3cb7f8b4a37176d2f26e29374fe55c7c5b54cc8b42aa3736a4baa5dcb6e"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.3/prx-aarch64-linux"
      sha256 "d03851822515b089dfc61b6961b2fd560d5d89e851fa39f65a51a7a8ccf25eeb"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
