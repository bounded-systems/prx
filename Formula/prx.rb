# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.23.1"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.23.1/prx-aarch64-darwin"
      sha256 "885511cee3b6c6fc28f400bbb854326d2917263657bb9c7b641596b2d67782ee"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.23.1/prx-x86_64-linux"
      sha256 "673341d9e6f6e37ad456817d68bc8dee31c67b28c0349baae7e1c512d0023bda"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.23.1/prx-aarch64-linux"
      sha256 "68c66c7b7895c999786bd26b0a4c51007766068ce759e89093ac055fe110ab87"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
