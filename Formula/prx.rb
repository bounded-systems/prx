# Homebrew formula for prx. Because this lives in the prx repo's Formula/ dir,
# the repo doubles as a tap:  brew install bounded-systems/prx/prx
#
# Auto-maintained: the release-binary workflow's update-hashes job rewrites the
# version + per-platform url/sha256 on each release (see .github/workflows/release-binary.yml).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.1.1"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.1.1/prx-aarch64-darwin"
      sha256 "f30b8c35f4c00266981490cf2fd00d178aaf47d7b65e958dee173b436f69b4b5"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.1.1/prx-x86_64-linux"
      sha256 "8d491ae4c5b9c9a3c41fe5090bb09312f5f8f6f4dfe0b6e9ae627ba4660e6faa"
    end
  end

  def install
    # The release asset is a single self-contained binary named prx-<target>.
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
