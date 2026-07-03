# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.27.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.27.0/prx-aarch64-darwin"
      sha256 "92b4641e899488e49223b093c93286790e70e43b4668865c064e8e039edccf89"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.27.0/prx-x86_64-linux"
      sha256 "69ddff5658f21903654660cee76d219389d4f505041870dd7c730614824dfd04"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.27.0/prx-aarch64-linux"
      sha256 "51abd7fbd12f69562ae731e666e325320ab78ae1e5b6c7653c8095237f5f7b14"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
