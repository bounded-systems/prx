# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.13.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.13.0/prx-aarch64-darwin"
      sha256 "631d05a102207cac161076ab716ba1bf360676a91c53664fef8b89d0617bba03"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.13.0/prx-x86_64-linux"
      sha256 "3e709dbb174fa32ec0d3e3f1402115d1e05ba2c80e4768fdd9739ee73ceeb150"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.13.0/prx-aarch64-linux"
      sha256 "7299f59835b8fb79fc9ba628b3d3320c6b31809b6120b644346095525e7e21bf"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
