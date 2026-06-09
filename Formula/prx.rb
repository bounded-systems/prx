# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.9.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.9.0/prx-aarch64-darwin"
      sha256 "eb1b3bf3dd6b1db4ccf8722011a58ecab10208db7344b0c54a68ceb36322bd58"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.9.0/prx-x86_64-linux"
      sha256 "c342c5ec11df48084256e9c881353af2f745909ac8fa594bbb4385e035c3e693"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.9.0/prx-aarch64-linux"
      sha256 "b6c030f5cdcdd9d79c6b7e9f05a1910be047088464e93439f670d7a0a4385e33"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
