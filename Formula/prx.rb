# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.25.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.25.0/prx-aarch64-darwin"
      sha256 "b5180b42465a01e937a859291d12ef5a3d26a602340857c62bd67786ee69cf85"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.25.0/prx-x86_64-linux"
      sha256 "92888a398a1cce8642884d9e869851efb6010da80b46b676d46eb06dfefd945c"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.25.0/prx-aarch64-linux"
      sha256 "bd0ee44c1004e36192cb58c7c31c253b4de24e4c721378aed3a31eea5974ae86"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
