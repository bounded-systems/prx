# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.7.4"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.7.4/prx-aarch64-darwin"
      sha256 "c945e8414ae32aafa259684da1933b478742943e560783a9bcaef6e6c5653451"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.7.4/prx-x86_64-linux"
      sha256 "ecb1b6cfa266f0863098f475a54dc9968afe46e81c05b3e3d6e6134bdc234166"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
