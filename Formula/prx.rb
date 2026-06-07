# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.8.1"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.8.1/prx-aarch64-darwin"
      sha256 "b0efc8036086127b5c0cd67e97d3f61a6e31ccccf83b47e0b1cb19ca3a4cdbbf"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.8.1/prx-x86_64-linux"
      sha256 "4a620837f78870a21229449e7598ec55f25fd0a571644bc9160647c731714488"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
