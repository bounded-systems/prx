# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.10.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.10.0/prx-aarch64-darwin"
      sha256 "5e29bbd3bfe0f5c0c7b27ce752c0168dfb3488ec2edeab6d78c151f04115b507"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.10.0/prx-x86_64-linux"
      sha256 "f1d3c3c2b422e026e18866f1f7b864c98c61fff04f683770fbb504667e3ad305"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.10.0/prx-aarch64-linux"
      sha256 "34218fe39b4c6b793c38a5361d24fa9bf61ea2eaec4548ed540d9af8ba510bad"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
