import sys,unittest
sys.path.insert(0,'local_jev')
from layout import ordered,disjoint
class OrderTest(unittest.TestCase):
 def test_header_two_columns_footer(self):
  boxes=[[0,0,100,15],[0,30,45,60],[0,70,45,110],[55,30,100,65],[55,70,100,110],[0,140,100,150]]
  regions=[{'bbox':b,'id':i} for i,b in enumerate(boxes)]
  self.assertEqual([r['id'] for r in ordered(list(reversed(regions)))],list(range(6)))
class CoverageTest(unittest.TestCase):
 def test_duplicate_partial_and_new(self):
  existing=[{'bbox':[0,0,100,40]}]
  self.assertFalse(disjoint([0,0,100,40],existing))
  self.assertFalse(disjoint([90,0,140,40],existing))
  self.assertTrue(disjoint([0,60,100,80],existing))
if __name__=='__main__':unittest.main()
