# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.29.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.29.0/prx-aarch64-darwin"
      sha256 "5d1d576e1a865a0da173d7a5ecb6bc3f6c21f7cf905cbfa5a10bf1699b1f2bea"
    end
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.29.0/prx-x86_64-darwin"
      sha256 "6b2940f0dc4c683b04dbdfc43a351145512a8f98ba54c0625afd0ebb14411d33"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.29.0/prx-x86_64-linux"
      sha256 "f009464420399f93d69c7cab60f6e0c2d9a969bdbba1740de3f55aaa429388e1"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.29.0/prx-aarch64-linux"
      sha256 "81b569a2a0016197cc8b7fbc97835694e09fea20c02b62c7e71ae37ac0af1b17"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
