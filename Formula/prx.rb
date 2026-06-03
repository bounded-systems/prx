# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.1.10"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.1.10/prx-aarch64-darwin"
      sha256 "d575b782bc8c1e8cee170a71d6bf41d9df3300c553e457da134466e7ed10e897"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.1.10/prx-x86_64-linux"
      sha256 "0e990113f8172d64c4258d7ef3409a928a97cbaab60bd0028bab853bfb98692d"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
