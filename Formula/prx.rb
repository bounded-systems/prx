# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.3.5"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.3.5/prx-aarch64-darwin"
      sha256 "e8e552e8a9d2fdbf45140a932fcc962fc7577144fbe1380ff6050a432b2ab6b6"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.3.5/prx-x86_64-linux"
      sha256 "75df906cfcfc3f51241d6818456ff6360d315bd6ac04b7efda8a3929c6917ff4"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
