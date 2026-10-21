import copy
import importlib.util
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('prebuilt', pathlib.Path(__file__).with_name('prebuilt-release.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.receipt = dict(revision='a'*40, archiveSha256='b'*64, imageId='sha256:'+'c'*64,
                            previousImageId='sha256:'+'d'*64, buildPassed=True, deployed=False)
        self.source = dict(gitRevision='a'*40, archiveSha256='b'*64)
        self.raw = json.dumps(self.receipt).encode()
        self.expected = dict(revision='a'*40, archive='b'*64, image='sha256:'+'c'*64, receipt=p.sha(self.raw))
        self.image = dict(Id=self.expected['image'], Os='linux', Architecture='amd64', Config={'Labels': {
            'org.merv.native-git-protocol':'1', 'org.merv.sandboxes-image':'sha256:'+'e'*64}})
        self.previous = dict(Image=self.receipt['previousImageId'], State={'Running':True,'Health':{'Status':'healthy'}})

    def check(self, raw=None, archive=None):
        return p.verify(self.raw if raw is None else raw, json.dumps(self.source).encode(),
                        self.expected['archive'] if archive is None else archive, self.expected,
                        self.image, self.previous, 'sha256:'+'e'*64)

    def test_exact_attested_binding_passes(self):
        self.check()

    def test_arbitrary_success_boolean_or_changed_receipt_not_trusted(self):
        for field, value in [('revision','f'*40),('imageId','sha256:'+'f'*64),('archiveSha256','f'*64),('buildPassed',False)]:
            receipt={**self.receipt,field:value}
            with self.assertRaisesRegex(RuntimeError,'receipt hash'): self.check(json.dumps(receipt).encode())

    def test_source_and_archive_mismatch(self):
        for field in self.source:
            old=self.source[field];self.source[field]='f'*len(old)
            with self.assertRaises(RuntimeError): self.check()
            self.source[field]=old
        with self.assertRaisesRegex(RuntimeError,'archive'):self.check(archive='f'*64)

    def test_exact_image_native_platform_and_pin_required(self):
        paths=[(['Id'],'sha256:'+'f'*64),(['Architecture'],'arm64'),(['Os'],'windows'),
               (['Config','Labels','org.merv.native-git-protocol'],None),
               (['Config','Labels','org.merv.sandboxes-image'],'wrong')]
        original=copy.deepcopy(self.image)
        for path,value in paths:
            target=self.image
            for key in path[:-1]:target=target[key]
            target[path[-1]]=value
            with self.assertRaises(RuntimeError):self.check()
            self.image=copy.deepcopy(original)

    def test_changed_or_unhealthy_predecessor_refused(self):
        original=copy.deepcopy(self.previous)
        for path,value in [(['Image'],'wrong'),(['State','Running'],False),(['State','Health','Status'],'unhealthy')]:
            target=self.previous
            for key in path[:-1]:target=target[key]
            target[path[-1]]=value
            with self.assertRaises(RuntimeError):self.check()
            self.previous=copy.deepcopy(original)

    def test_even_pinned_receipt_requires_success_and_undeployed(self):
        for field,value in [('buildPassed',False),('buildPassed',1),('deployed',True)]:
            raw=json.dumps({**self.receipt,field:value}).encode()
            self.expected['receipt']=p.sha(raw)
            with self.assertRaises(RuntimeError):self.check(raw)

if __name__ == '__main__':unittest.main()
