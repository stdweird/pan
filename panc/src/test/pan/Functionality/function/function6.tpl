#
# tests of splice on lists
#
# @expect="count(/nlist[@name='profile']/list[@name='s1']/*)=7 and count(/nlist[@name='profile']/list[@name='s2']/*)=7 and count(/nlist[@name='profile']/list[@name='s3']/*)=7 and count(/nlist[@name='profile']/list[@name='s4']/*)=4 and count(/nlist[@name='profile']/list[@name='s5']/*)=4 and count(/nlist[@name='profile']/list[@name='s6']/*)=4 and count(/nlist[@name='profile']/list[@name='s7']/*)=4 and /nlist[@name='profile']/list[@name='s1']/*[1]='1' and /nlist[@name='profile']/list[@name='s2']/*[6]='1' and /nlist[@name='profile']/list[@name='s3']/*[3]='1' and /nlist[@name='profile']/list[@name='s4']/*[1]='b' and /nlist[@name='profile']/list[@name='s5']/*[4]='d' and /nlist[@name='profile']/list[@name='s6']/*[4]='e' and /nlist[@name='profile']/list[@name='s7']/*[3]='XXX'"
# @format=pan
#

object template function6;

# prepend
"/s1" = splice(list("a","b","c","d","e"), 0, 0, list("1","2"));

# append
"/s2" = splice(list("a","b","c","d","e"), 5, 0, list("1","2"));

# insert before c
"/s3" = splice(list("a","b","c","d","e"), 2, 0, list("1","2"));

# remove first
"/s4" = splice(list("a","b","c","d","e"), 0, 1);

# remove last
"/s5" = splice(list("a","b","c","d","e"), -1, 1);

# remove last but one
"/s6" = splice(list("a","b","c","d","e"), -2, 1);

# replace c and d by XXX
"/s7" = splice(list("a","b","c","d","e"), 2, 2, list("XXX"));
