# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.3.6"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.3.6/prx-aarch64-darwin"
      sha256 "071cefbca4265fd25d5226eca2deee1c61c04593deb0cf55f9b01a1887944134"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.3.6/prx-x86_64-linux"
      sha256 "158dbadb6ef8fc3c55147cc5787494bee3ae2f8a41183875295ee5e2ab131331"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
