# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.4.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.4.0/prx-aarch64-darwin"
      sha256 "0cf034bc8cb59f25b06d28bfd964496a266d47a1fc482924bae3f1b94ec93921"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.4.0/prx-x86_64-linux"
      sha256 "130598ca1b9705fdf14e7a2056a993965cb130a20612137fdd163c658ad35d38"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
