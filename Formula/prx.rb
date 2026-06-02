# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.1.2"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.1.2/prx-aarch64-darwin"
      sha256 "015b55b987e19a4d0e30269bc1a2422fe8253eec15492aeedac2379e4bb1ad8e"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.1.2/prx-x86_64-linux"
      sha256 "6549e21c160883d342ba82b57ec2838ef38650c90ea03be80d3ac201b0b871f5"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
