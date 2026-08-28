# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "2.0.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v2.0.0/prx-aarch64-darwin"
      sha256 "8a03f012a153f2a9e509275276e02b1eb6934ebb56916b952b7d2484d5841bfc"
    end
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v2.0.0/prx-x86_64-darwin"
      sha256 "6b03633c1aad520102d6415d9830a534ff6cf5b58ae19aca2ecd45b5397dcd00"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v2.0.0/prx-x86_64-linux"
      sha256 "5f072d73279d6ff96b323787720f3bb24509a7a9ea8a7be1ff14bc1e4ae407fd"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v2.0.0/prx-aarch64-linux"
      sha256 "47cea2c241f8d939a2adc652052d9ccbc602aab579cc092bceaa1acf1ac6e4bd"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
