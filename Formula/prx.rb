# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "1.0.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v1.0.0/prx-aarch64-darwin"
      sha256 "5c028702a1697e93a8443c6feb5986e7b748934b55f8490ecd1a55e899d3a301"
    end
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v1.0.0/prx-x86_64-darwin"
      sha256 "2eb72b301e99c827011aa12c2f73bdf9a48729f853f6ba572a7a03ee693286c5"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v1.0.0/prx-x86_64-linux"
      sha256 "cfffb877138d68d5c57d4b8d890fdaaab248da78cd8dbdbcbaf931efad185585"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v1.0.0/prx-aarch64-linux"
      sha256 "2b76950b881fbeec4868789955291dd03aaa593053f4697868c7579d67d51ea5"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
