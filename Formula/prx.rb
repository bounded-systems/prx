# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.19.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.19.0/prx-aarch64-darwin"
      sha256 "58be1446c58c63c06ab7cd1eba52e8ec77d2fdd551d58e315cc6b3a851cdd8d2"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.19.0/prx-x86_64-linux"
      sha256 "4dd7b0e9d5c7acaf853fd6f15677635c27763fd08a754f2aa49858e534bdee1a"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.19.0/prx-aarch64-linux"
      sha256 "152f60881b4d061a37e6071c8005614cb46e4897ecaa2fe5593979ba274ff758"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
