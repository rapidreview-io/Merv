#!/usr/bin/env python3
"""Verify an explicitly approved build receipt and freeze its inputs for Main promotion.
The receipt SHA is an operator-reviewed attestation, not a self-authenticating buildPassed flag.
Never resolves an image tag, builds, prunes, stops Main, or changes served UI.
"""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify(receipt_bytes, source_bytes, archive_hash, expected, image, previous, sandboxes):
    require(sha(receipt_bytes) == expected['receipt'], 'Prebuilt receipt hash mismatch')
    receipt, source = json.loads(receipt_bytes), json.loads(source_bytes)
    require(receipt['revision'] == source['gitRevision'] == expected['revision'], 'Prebuilt source revision mismatch')
    require(receipt['archiveSha256'] == source['archiveSha256'] == archive_hash == expected['archive'], 'Prebuilt archive mismatch')
    require(receipt['imageId'] == image['Id'] == expected['image'], 'Prebuilt immutable image mismatch')
    require(receipt['buildPassed'] is True and receipt['deployed'] is False, 'Prebuilt receipt is not an undeployed successful build')
    require(receipt['previousImageId'] == previous['Image'], 'Prebuilt predecessor changed')
    require(previous['State']['Running'] is True and previous['State'].get('Health', {}).get('Status') == 'healthy', 'Prebuilt predecessor is not running healthy')
    labels = image['Config'].get('Labels') or {}
    require(labels.get('org.merv.native-git-protocol') == '1', 'Prebuilt image lacks native protocol capability')
    require(labels.get('org.merv.sandboxes-image') == sandboxes, 'Prebuilt Sandboxes image differs from live pin')
    require(image['Os'] == 'linux' and image['Architecture'] == 'amd64', 'Prebuilt platform mismatch')
    return receipt, source


def run(argv):
    p = subprocess.run(argv, capture_output=True)
    require(p.returncode == 0, 'Prebuilt inspection refused; private diagnostics suppressed')
    return p.stdout


def main():
    build, destination, image_id, revision, archive_hash, receipt_hash, sandboxes = sys.argv[1:]
    build, destination = pathlib.Path(build), pathlib.Path(destination)
    expected = dict(image=image_id, revision=revision, archive=archive_hash, receipt=receipt_hash)
    receipt_bytes = (build / 'build-manifest.json').read_bytes()
    source_bytes = (build / 'source-manifest.json').read_bytes()
    archive = build / 'source.tar.gz'
    # Copy into the new release under the maintenance lock; hash those exact retained bytes.
    # A failed validation leaves only diagnostic release inputs, never live state changes.
    shutil.copyfile(archive, destination / 'source.tar.gz')
    actual_hash = sha((destination / 'source.tar.gz').read_bytes())
    image = json.loads(run(['docker', 'image', 'inspect', image_id]))[0]
    previous = json.loads(run(['docker', 'inspect', 'merv-typescript-control-1']))[0]
    _, source = verify(receipt_bytes, source_bytes, actual_hash, expected, image, previous, sandboxes)
    (destination / 'prebuilt-build-manifest.json').write_bytes(receipt_bytes)
    (destination / 'prebuilt-source-manifest.json').write_bytes(source_bytes)
    source['release'] = destination.name
    (destination / 'source-manifest.json').write_text(json.dumps(source, indent=2) + '\n')
    (destination / 'prebuilt-approval.json').write_text(json.dumps(expected, indent=2) + '\n')


if __name__ == '__main__':
    main()
