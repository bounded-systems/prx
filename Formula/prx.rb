# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.23.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.23.0/prx-aarch64-darwin"
      sha256 "6b23d5c5af8ea2bc2bc3f95d0886e3a5f091f9a5251002acd4b4e7733fa6e725"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.23.0/prx-x86_64-linux"
      sha256 "c98a8b87fb11473fa7e760d87f63fd1163f2f2231cc536a747167c0974ee13cf"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.23.0/prx-aarch64-linux"
      sha256 "89316f6106a82126e8e51c1908e9e33441f4db59f03e406955d74b06b9c496c6"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
