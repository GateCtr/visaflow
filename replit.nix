{pkgs}: {
  deps = [
    pkgs.systemd
    pkgs.xorg.libxcb
    pkgs.libgbm
    pkgs.pango
    pkgs.mesa
    pkgs.expat
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libX11
    pkgs.alsa-lib
    pkgs.gtk3
    pkgs.libxkbcommon
    pkgs.libdrm
    pkgs.cups
    pkgs.at-spi2-atk
    pkgs.dbus
    pkgs.nspr
    pkgs.nss
    pkgs.glib
  ];
}
