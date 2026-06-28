# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.14.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.14.0/prx-aarch64-darwin"
      sha256 "0028922301799891028cca3b04c79b68a259aca148d188e212421fcfcada9acc"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.14.0/prx-x86_64-linux"
      sha256 "93dd9349741ba9f9fc9ee96f909abed33cc38c0198da33e0b221975835fe4ac6"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.14.0/prx-aarch64-linux"
      sha256 "fc06672488ae7ae550f92fc9227eecee246acb36637333480fd909623669ed9c"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
