# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.24.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.24.0/prx-aarch64-darwin"
      sha256 "16fc624e5a8e8d2589f42976cd432a6f214a3fccab9ad6afa7c11adec5b8529d"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.24.0/prx-x86_64-linux"
      sha256 "16940e20c495fb47f21d77a13ea8b83c7f327063bf982c5929ddbf2e26d83e10"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.24.0/prx-aarch64-linux"
      sha256 "41ff0533ced2e028febb0b7c4e5dbbc9ade64038312553846b77eeee0a18f12b"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
