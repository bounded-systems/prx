# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.28.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.28.0/prx-aarch64-darwin"
      sha256 "20113f2c18ed0fea295f07fda97bbeed552a14c5b0f4f87310c65a10ad067cd5"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.28.0/prx-x86_64-linux"
      sha256 "e6d26f8ad82c694456e2ed900cd50f4382c2ab31e35ded413d70d6330f56e2d2"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.28.0/prx-aarch64-linux"
      sha256 "3cf69cfb4335412fcf97ac3e6fffae99358094f4857e3838db71cf22b79c9bbe"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
