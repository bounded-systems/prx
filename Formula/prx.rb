# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.26.2"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.2/prx-aarch64-darwin"
      sha256 "7008e6dfe7d6bf19e23eda80d508ee4cafae75ac88df593c2707af99da24db92"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.2/prx-x86_64-linux"
      sha256 "afee2d19322d5017c723ce3cc2b8683181c6e2b2c782f3c6c966367f783aa0b7"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.2/prx-aarch64-linux"
      sha256 "5baa06d0ea79daa85e4468767cb9a8522cc567b0fbb9c6b2170308f4d30c75ef"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
