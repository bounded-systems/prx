# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.16.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.16.0/prx-aarch64-darwin"
      sha256 "8a4d4f5c4f019cd0020208cc71aa56698eba233c7ad868845db9778db4291566"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.16.0/prx-x86_64-linux"
      sha256 "0d63220f90f48b4bfe221a3aebb6614a66c50715e846eb9ca14f8806d3056f04"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.16.0/prx-aarch64-linux"
      sha256 "9c2ec935026b84bbbf94aec1afd60a6268e16ea5baced1c57d1ee4d9a57f99c3"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
