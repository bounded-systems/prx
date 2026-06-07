# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.7.3"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.7.3/prx-aarch64-darwin"
      sha256 "a18c97207ed41c1867bcf131963daec6098b6af81ee66d6e427bd0133207dcc0"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.7.3/prx-x86_64-linux"
      sha256 "2df9ad2943c4959ef75ea4d6685aead7424b8bea96816afb5ce88888bf7b95a8"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
