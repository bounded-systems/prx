# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.3.4"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.3.4/prx-aarch64-darwin"
      sha256 "dbc292da253be32b4e2b73ee8ddc50738639b47b871c665a2b57026b2d0e7453"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.3.4/prx-x86_64-linux"
      sha256 "737e187c265e96cac6fb5129ad61b1cb6d5dfd1eba8dcb97e89f58a55c00612f"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
