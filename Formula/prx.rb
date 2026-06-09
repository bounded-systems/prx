# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.8.5"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.8.5/prx-aarch64-darwin"
      sha256 "463c5a08397dfd7018c1ffda881bf2cf339c45c08f9581a96edd30bb521a1cdb"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.8.5/prx-x86_64-linux"
      sha256 "cc6980f0a97bbcdd999965515f593467b6296f9e6854b2463f6c138dbb7cb304"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.8.5/prx-aarch64-linux"
      sha256 "395612dc17305e57d8d57bc5ce1b13064e35ea7af36a6b32f7812cfc0e55210d"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
