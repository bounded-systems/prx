# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.26.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.0/prx-aarch64-darwin"
      sha256 "06ede81bc0dce6cfa2b1526cdefad342d23a71e81cebc29d8db6aa1af662473e"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.0/prx-x86_64-linux"
      sha256 "22ddcd0e6e676cc59f1165c5a2ea72f952d642dae7b3e666ca8a49b9c9cdee2d"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.0/prx-aarch64-linux"
      sha256 "4ca3aba9c7bc815afd0d8ce61cbf291abb28e95ccdc6bbca2d11167f5d918751"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
