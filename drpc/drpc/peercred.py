"""Who is on the other end of a Unix socket, according to the kernel.

The peer can't lie about this: the kernel records the credentials of the
process that called connect(). It's how the Docker socket and friends know
who you are without a login step.
"""

import pwd
import socket
import struct
import sys
from dataclasses import dataclass


@dataclass
class PeerCred:
    uid: int
    pid: int | None

    @property
    def username(self) -> str:
        try:
            return pwd.getpwuid(self.uid).pw_name
        except KeyError:  # a uid with no passwd entry, e.g. inside a container
            return str(self.uid)


def peer_credentials(sock) -> PeerCred | None:
    """The connecting process's uid and pid, or None if the platform won't say."""
    try:
        if sys.platform.startswith("linux"):
            pid, uid, _gid = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            return PeerCred(uid, pid)
        if sys.platform == "darwin" or "bsd" in sys.platform:
            SOL_LOCAL, LOCAL_PEERCRED, LOCAL_PEERPID = 0, 0x001, 0x002
            # struct xucred { u_int cr_version; uid_t cr_uid; short cr_ngroups; gid_t cr_groups[16]; }
            xucred = struct.Struct("IIh16I")
            _version, uid = struct.unpack_from("II", sock.getsockopt(SOL_LOCAL, LOCAL_PEERCRED, xucred.size))
            try:
                (pid,) = struct.unpack("i", sock.getsockopt(SOL_LOCAL, LOCAL_PEERPID, 4))
            except OSError:  # LOCAL_PEERPID is macOS-only
                pid = None
            return PeerCred(uid, pid)
    except OSError:
        pass
    return None
