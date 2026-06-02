# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.1.7"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.1.7/prx-aarch64-darwin"
      sha256 "72ebd90c526772ee8469b355746b28b9d3cbfb9ac768f94e9862ff6e64b5608b"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.1.7/prx-x86_64-linux"
      sha256 "1cabace1f5959be9382dd71a6014548267d9577c2b004759ea2b7e7b9d7defd0"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
