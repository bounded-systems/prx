# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.17.0"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.17.0/prx-aarch64-darwin"
      sha256 "b78087afcfc34db74482803824657e26665bd13c6684bf861dacce038492b65b"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.17.0/prx-x86_64-linux"
      sha256 "814fc583794dfd547f52e2e9d4a0473effeee5a07322301ed6c455fbd984a73f"
    end
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.17.0/prx-aarch64-linux"
      sha256 "ad8805794a5356a5161b6aa1450af097812dd30abe15c6a2281d7e44ab102f97"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
