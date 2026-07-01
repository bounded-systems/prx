# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.26.1"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.1/prx-aarch64-darwin"
      sha256 "8f637ea76988d7e89911b94618205657dc943105056e3737a0898224eba6082b"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.1/prx-x86_64-linux"
      sha256 "b9086c588d48f6664b8d2354708f67b268c6d1eda95ab4a4c6880b3d840d9d4e"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.26.1/prx-aarch64-linux"
      sha256 "7e321dac3caf2d36ed3abafe9fda686bf8fb2e3dc853266aab08b9127390db66"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
