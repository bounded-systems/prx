# Homebrew formula for prx. This repo doubles as a tap:
#   brew tap bounded-systems/prx https://github.com/bounded-systems/prx
#   brew install prx
# Auto-maintained by .github/workflows/release-binary.yml (update-hashes job).
class Prx < Formula
  desc "Agent-run PR contract / work-unit CLI"
  homepage "https://github.com/bounded-systems/prx"
  version "0.7.1"

  on_macos do
    on_arm do
      url "https://github.com/bounded-systems/prx/releases/download/v0.7.1/prx-aarch64-darwin"
      sha256 "6984d096c3b7288993a111f9f6cbecb68704f27074e844d9ac65f28a42ebfbd9"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bounded-systems/prx/releases/download/v0.7.1/prx-x86_64-linux"
      sha256 "d26f553f3624b74ade650a4ba766792e57c7a758b2bc3f3e082e5dd27f42bff0"
    end
  end

  def install
    bin.install Dir["prx-*"].first => "prx"
  end

  test do
    assert_match(/git-/, shell_output("#{bin}/prx --version"))
  end
end
