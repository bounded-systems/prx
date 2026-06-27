# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.12.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.12.0/prx-aarch64-darwin"
      sha256 "483cd4543ba2068df47a38979bfc11f6c6cbbe574f50ee23929372415008b9f8"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.12.0/prx-x86_64-linux"
      sha256 "6391a1b8e52f2ebcd0534d42be03c1180dcd3b7051518d349813b82cec8a6873"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.12.0/prx-aarch64-linux"
      sha256 "48c2a632e49f201949293986dcea245d45be943d26efeb76f03ee7533f709432"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
