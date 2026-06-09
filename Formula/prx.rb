# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.8.4"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.8.4/prx-aarch64-darwin"
      sha256 "f0052beebc18a10600cf168eedb0ec79b466eb7c1710117da9690b40b52da8c6"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.8.4/prx-x86_64-linux"
      sha256 "dab2371f64172b62004983b42cf32546b8b585fe9c8ace8c73175cd2dd818470"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.8.4/prx-aarch64-linux"
      sha256 "397205939673acf581925fb19728a627d96afd28edfd8605b37d033d586d1a4c"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
