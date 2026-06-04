# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.1.23"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.1.23/prx-aarch64-darwin"
      sha256 "eb0ab5ed16b18c52347c3419f132ccb47b50996127b0d5fc836d5e97b8e08a4e"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.1.23/prx-x86_64-linux"
      sha256 "a765755126cc14c73c95480ba4d28f5bf67c776861d8956211365d57efde2362"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
