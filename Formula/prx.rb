# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.16.1"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.16.1/prx-aarch64-darwin"
      sha256 "0a5da66724f939eda395072855dd762c1fe29804a14c6c62ccf5b5847851175a"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.16.1/prx-x86_64-linux"
      sha256 "9efe16092fbf0df6ca206fed2151ca1d3f2a6cce3eabf4a83a49563178d5f2b3"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.16.1/prx-aarch64-linux"
      sha256 "e2fc3c51d88ff5aadf0ffcdee87feb8b413891fec361183cfe40f3d1e47fa4f0"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
