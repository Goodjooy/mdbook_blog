# 手动完成动态分发初体验

近日，由于在水群时和群友讨论起了 rust 中关于 `dyn Trait` 的相关细节，于是突发奇想，想试图手动实现一个简易的动态分发的实现

## 动态派发谁呢？

由于最近在捣鼓 [mini_lsm](./lsm/summary.md), 那么就干脆直接使用 其中的 `Entry`, 来制作一个简单的 `trait` 然后动态派发它

```rust
pub trait DataEntry: Sized{
    fn key(&self) -> &[u8];

    fn value(&self) -> &[u8];
}
```

注意到，由于如果需要 `trait` 能够动态派发，那就要求 `trait` 的全部函数接口要类似于别的语言的 `interface` 那样，全部都是方法，并且不能是取得所有权或者返回 `Self`

## 如何派发？

下一个问题就是：如何派发？

非常顺其自然地，我想到的 CPP 中的虚函数和虚函数表，那么就让我们考虑一下，虚函数表里面要来点什么吧

```rust
struct VirtualTable{
    fn_ptr_key:...,
    fn_ptr_value:...
}
```

但是当开始写虚表结构体时，却碰到了一个问题。就是：原始的 trait 里面的接口的函数指针的函数签名是什么样子的？

不妨假设那个实现了 `DataEntry` 的类型为 T. 有几种可能的方式表示函数指针的函数签名

1. 原封不动地保留，也就是函数签名就是 `fn(&T)->&[u8]` 但是很遗憾，这有一定的问题。❌
   - 这个函数签名依然保持了 T, 这可不是动态分发的类型抹除要的东西
2. 那就将 `&Self` 更换成 `*const ()` 这样类型就抹除掉了，同时由于此时 `&[u8]` 的生命周期莫得约束了，
   所以同时也转换成 `*const [u8]`全部去除生命周期标记信息。 ✅
   > 由于 `&[u8]` 的 特殊性，函数的返回值也可以使用 `(*const u8, usize)` 的形式然后使用
   > [`slice::from_raw_part`](https://doc.rust-lang.org/std/slice/fn.from_raw_parts.html) 重新获得 `&[u8]`

为了方便起见，准备一个 private 的 `trait` 来完成这些函数接口吧

```rust
pub trait DataEntry: Sized{
#    fn key(&self) -> &[u8];
#
#    fn value(&self) -> &[u8];

    // 首先需要添加一个接口，能够将 `*const ()` 变成 `* const Self`
    fn cast_const(ptr: *const ()) -> *const Self;
}

trait DataEntryRaw: DataEntry {
    /// # Safety
    /// this 为指向 self 的指针，且指针指向的内容已经初始化了
    unsafe fn key(this: *const ()) -> *const [u8] {
        let this = Self::cast_const(this);
        let this = unsafe { this.as_ref() }.unwrap();
        this.key() as _
    }
    /// # Safety
    /// this 为指向 self 的指针，且指针指向的内容已经初始化了
    unsafe fn value(this: *const ()) -> *const [u8] {
        let this = Self::cast_const(this);
        let this = unsafe { this.as_ref() }.unwrap();
        this.value() as _
    }
}

impl<T: DataEntry> DataEntryRaw for T {}
```

然后，刚刚的`VirtualTable` 就能完成了。 同时为了便于使用，提供部分便于使用的接口

```rust
struct VirtualTable{
    // vtb
    fn_ptr_key: fn(*const ()) -> *const [u8];
    fn_ptr_value: fn(*const ()) -> *const [u8];

}

impl VirtualTable{
    fn new<T: DataEntryRaw>() ->Self{
        Self{
            fn_ptr_key: <T as DataEntryRaw>::key,
            fn_ptr_value: <T as DataEntryRaw>::value
        }
    }

    fn call_key(&self, ptr: *const ()) -> &[u8]{
        let ret: *const [u8] = (self.fn_ptr_key)(ptr);
        unsafe { ret.as_ref() }.unwrap()
    }

    fn call_value(&self, ptr: *const ()) -> &[u8]{
        let ret: *const [u8] = (self.fn_ptr_value)(ptr);
        unsafe { ret.as_ref() }.unwrap()
    }
}
```

## 开始派发吧

虽然以上的代码可能有点问题，但是目前看起来是问题不大，总之先开始完成动态派发的主体吧

对于动态派发的类型，里面需要 2 个 ptr, 其中一个指向存在堆上的原始数据的地址，另一个是指向 virtual table 的指针

对于第一个指针，我们只能使用裸指针来记录，而对于后者，我们可以直接使用 `Box<VirtualTable>` 以不用操心对应的内存释放过程。

```rust
#use core::ptr::NonNull;

struct DynDispatch{
    raw: NonNull<()>,
    vtb: Box<VirtualTable>
}
```

对于这个类型，我们需要实现以下的 `trait`

- [`Drop`](https://doc.rust-lang.org/std/ops/trait.Drop.html) 使用了堆上的内存分配，在析构时必须同时将堆内存释放
- `DataEntry` 动态分发的 `DataEntry` 也是 `DataEntry`

首先就从相对比较容易的 `DataEntry` 实现开始吧

```rust
#struct DynDispatch {
#    raw: NonNull<()>,
#    vtb: Box<VirtualTable>,
#}
#
impl DataEntry  for DynDispatch {
    fn key(&self) -> &[u8] {
        // 直接调用 vtb 对应的方法
        self.vtb.call_key(self.raw.as_ptr() as *const ())
    }

    fn value(&self) -> &[u8] {
        // 直接调用vtb 对应方法
        self.vtb.call_value(self.raw.as_ptr() as *const ())
    }

    fn cast_const(ptr: *const ()) -> *const Self {
        ptr as _
    }
}
```

接下来是 [`Drop`](https://doc.rust-lang.org/std/ops/trait.Drop.html) 但是在这之前，我们首先添加与 `Drop` 配套的 `Self::new` 接口

```rust
use core::ptr::NonNull;
use std::alloc::{alloc, Layout};
use std::mem::size_of;

#struct DynDispatch {
#    raw: NonNull<()>,
#    vtb: Box<VirtualTable>,
#}
#
impl DynDispatch {
    pub fn new<T: DataEntry + 'static>(data: T) -> Self {
        let layout = Layout::new::<T>();
        // 检查 zst
        let ptr = if size_of::<T>() == 0 {
            // 如果是zst,那任意的非空指针都行
            NonNull::dangling()
        } else {
            // 申请堆内存
            let ptr = unsafe { alloc(layout) } as *mut T;
            // 如果返回 null, 表明内存分配失败
            if ptr.is_null() {
                panic!("Alloc failure");
            }
            // 将数据写入堆内存中
            unsafe {
                core::ptr::write(ptr, data);
            };
            // 构造NonNull
            unsafe { NonNull::new_unchecked(ptr as *mut ()) }
        };
        Self {
            raw: ptr,
            vtb: Box::new(VirtualTable::new::<T>()),
        }
    }
}
```

在开始实现 [`Drop`](https://doc.rust-lang.org/std/ops/trait.Drop.html) 前，
注意到 [`dealloc`](https://doc.rust-lang.org/std/alloc/fn.dealloc.html) 的函数签名，
发现其同时需要被释放的内存的函数指针和对应的 [`Layout`](https://doc.rust-lang.org/stable/std/alloc/struct.Layout.html)。
但是在目前的实现中，没有存储对应的 `Layout` , 所以，需要将 `Layout` 加到某个地方。
我选择添加到 vtb 中。同时，对于 ZST 的指针，只是一个任意的合法指针，这种情况下不需要释放对应的内存，所以记录是否为 ZST 的标记也一并放进 vtb

> ZST: Zero Size Type 也就是占用空间大小为 0 的特殊类型

修改后的 vtb

```rust
struct VirtualTable {
    // mem
    is_zst: bool,
    layout: Layout,
    // vtb
#    fn_ptr_key: unsafe fn(*const ()) -> *const [u8],
#    fn_ptr_value: unsafe fn(*const ()) -> *const [u8],
}

impl VirtualTable {
    fn new<T: DataEntryRaw>() -> Self {
        Self {
            is_zst: size_of::<T>() == 0,
            layout: Layout::new::<T>(),
#           fn_ptr_key: <T as DataEntryRaw>::key,
#           fn_ptr_value: <T as DataEntryRaw>::value,
        }
    }
#
#    fn call_key(&self, ptr: *const ()) -> &[u8] {
#        let ret: *const [u8] = unsafe { (self.fn_ptr_key)(ptr) };
#        unsafe { ret.as_ref() }.unwrap()
#    }
#
#    fn call_value(&self, ptr: *const ()) -> &[u8] {
#        let ret: *const [u8] = unsafe { (self.fn_ptr_value)(ptr) };
#        unsafe { ret.as_ref() }.unwrap()
#    }
}
```

那么接下来，就可以愉快地实现 `Drop` 了

```rust
#struct DynDispatch {
#    raw: NonNull<()>,
#    vtb: Box<VirtualTable>,
#}
#
impl Drop for DynDispatch {
    fn drop(&mut self) {
        if !self.vtb.is_zst {
            unsafe { dealloc(self.raw.as_ptr() as *mut _, self.vtb.layout) }
        }
    }
}
```

## 不要派发，变回去

在某些情况下，我们希望动态派发的对象能够重新变回原来的类型。这种情况下，需要有办法能够检测目标类型和原始类型是否一致，这样才能保证正确的转换。
有以下几种方式记录类型

- [`TypeId`](https://doc.rust-lang.org/std/any/struct.TypeId.html) 可行，但是由于当前相关接口限制，将要求 `T: 'static`
- [`type_name`](https://doc.rust-lang.org/std/any/struct.TypeId.html) 也可行，并且没有生命周期的约束

> 由于抹除了类型，所以即原始类型的生命周期的信息也将一并丢失，这将可能出现悬挂引用，因此要求生命周期长度为 `‘static`。
> 如果需要支持带有生命周期的动态分发实现，可以考虑使用[PhantomData](https://doc.rust-lang.org/std/marker/struct.PhantomData.html)保留生命周期标记

这里使用 `type_name` 的方式，将 `type_name` 放在 vtb 中

修改后的 vtb 如下

```rust
struct VirtualTable {
    //ty
    ty_name: &'static str,
#    // mem
#    is_zst: bool,
#    layout: Layout,
#    // vtb
#    fn_ptr_key: unsafe fn(*const ()) -> *const [u8],
#    fn_ptr_value: unsafe fn(*const ()) -> *const [u8],
}

impl VirtualTable {
    fn new<T: DataEntryRaw + 'static>() -> Self {
        Self {
            ty_name: type_name::<T>(),
#            is_zst: size_of::<T>() == 0,
#            layout: Layout::new::<T>(),
#            fn_ptr_key: <T as DataEntryRaw>::key,
#            fn_ptr_value: <T as DataEntryRaw>::value,
        }
    }

#    fn call_key(&self, ptr: *const ()) -> &[u8] {
#        let ret: *const [u8] = unsafe { (self.fn_ptr_key)(ptr) };
#        unsafe { ret.as_ref() }.unwrap()
#    }
#
#    fn call_value(&self, ptr: *const ()) -> &[u8] {
#        let ret: *const [u8] = unsafe { (self.fn_ptr_value)(ptr) };
#        unsafe { ret.as_ref() }.unwrap()
#    }
#
    fn is_same_type<T>(&self)->bool{
        self.ty_name == type_name::<T>()
    }
}
```

准备工作完成后，就可以愉快地实现相关接口了

```rust
#pub struct DynDispatch {
#    raw: NonNull<()>,
#    vtb: Box<VirtualTable>,
#}
#
impl DynDispatch {
    pub fn try_cast_ref<T>(&self)->Option<&T>{
        if self.vtb.is_same_type::<T>(){
            Some(unsafe{ (self.raw.as_ptr() as *mut () as *const T).as_ref() }.unwrap())
        }else { None }
    }

    pub fn try_cast_mut<T>(& mut self)->Option<&mut T>{
        if self.vtb.is_same_type::<T>(){
            Some(unsafe{ (self.raw.as_ptr() as *mut T).as_mut() }.unwrap())
        }else { None }
    }

    pub fn try_cast_owned<T>(self)->Option<T>{
        if self.vtb.is_same_type::<T>(){
            let data = unsafe { std::ptr::read(self.raw.as_ptr() as *const () as _) };
            Some(data)

        }else { None }
    }
}
```

## 检测到存在的内存泄露

看起来大功告成了。现在，去问问 [miri](https://github.com/rust-lang/miri) 看看有没有内存问题吧

首先添加一个简易实现

```rust
use std::ops::Deref;

impl<K, V> DataEntry for (K, V)
    where
        K: Deref<Target=[u8]> + 'static + Sized,
        V: Deref<Target=[u8]> + 'static + Sized
{
    fn key(&self) -> &[u8] {
        &self.0
    }

    fn value(&self) -> &[u8] {
        &self.1
    }

    fn cast_const(ptr: *const ()) -> *const Self {
        ptr as _
    }
}
```

然后， 添加 main 函数，剩下的问问 miri

```rust
static VALUE: &[u8] = b"value001";

fn main() {
    let mut data = DynDispatch::new((b"key001".to_vec(), VALUE));

    assert_eq!(data.key(), b"key001");
    assert_eq!(data.value(), b"value001");

    let (k, _) = data.try_cast_mut::<(Vec<u8>, &[u8])>().unwrap();
    k.extend(b"key002");

    assert_eq!(data.key(), b"key001key002");
}
```

oops!, 出现内存泄漏了

```shell
The following memory was leaked: alloc2205 (Rust heap, size: 12, align: 1) {
    6b 65 79 30 30 31 6b 65 79 30 30 32             │ key001key002
}
```

重新检查我们的代码，很容易就能发现，当我们实现 `Drop` 时，并没有同时调用内部那个被抹除了类型的对象的`Drop` 函数。 因此，我们的虚函数表中也必须记录 `Drop` 的函数指针，以在 drop 时能够正确地释放内存

首先，调整 `DataEntryRaw` 的实现，以添加 `drop` 函数指针

```rust
#pub trait DataEntry: Sized {
#    fn key(&self) -> &[u8];
#
#    fn value(&self) -> &[u8];
#
#    // 首先需要添加一个接口，能够将 `*const ()` 变成 `* const Self`
#    fn cast_const(ptr: *const ()) -> *const Self;
#}
#
trait DataEntryRaw: DataEntry {
#    /// # Safety
#    /// this 为指向 self 的指针，且指针指向的内容已经初始化了
#    unsafe fn key(this: *const ()) -> *const [u8] {
#        let this = Self::cast_const(this);
#        let this = unsafe { this.as_ref() }.unwrap();
#        this.key() as _
#    }
#    /// # Safety
#    /// this 为指向 self 的指针，且指针指向的内容已经初始化了
#    unsafe fn value(this: *const ()) -> *const [u8] {
#        let this = Self::cast_const(this);
#        let this = unsafe { this.as_ref() }.unwrap();
#        this.value() as _
#    }
    /// # Safety
    /// this 为指向 self 的指针，且指针指向的内容已经初始化了
    unsafe fn drop(this: *const ()) {
        let this = Self::cast_const(this);
        let owned = unsafe { core::ptr::read(this) };
        drop(owned)
    }
}
#
#impl<T: DataEntry> DataEntryRaw for T {}
```

接着，为 `VirtualTable` 添加 指向 `drop` 的函数指针

```rust
struct VirtualTable {
#    //ty
#    ty_name: &'static str,
#    // mem
#    is_zst: bool,
#    layout: Layout,
    // vtb
    fn_ptr_key: unsafe fn(*const ()) -> *const [u8],
    fn_ptr_value: unsafe fn(*const ()) -> *const [u8],
    fn_ptr_drop: unsafe fn(*const ()),
}

impl VirtualTable {
#    fn new<T: DataEntryRaw>() -> Self {
#        Self {
#            ty_name: type_name::<T>(),
#            is_zst: size_of::<T>() == 0,
#            layout: Layout::new::<T>(),
#            fn_ptr_key: <T as DataEntryRaw>::key,
#            fn_ptr_value: <T as DataEntryRaw>::value,
#            fn_ptr_drop: <T as DataEntryRaw>::drop,
#        }
#    }
#
#    fn call_key(&self, ptr: *const ()) -> &[u8] {
#        let ret: *const [u8] = unsafe { (self.fn_ptr_key)(ptr) };
#        unsafe { ret.as_ref() }.unwrap()
#    }
#
#    fn call_value(&self, ptr: *const ()) -> &[u8] {
#        let ret: *const [u8] = unsafe { (self.fn_ptr_value)(ptr) };
#        unsafe { ret.as_ref() }.unwrap()
#    }
#
    /// # Safety
    /// 该接口只在 drop 时使用一次
    /// 使用该接口后不读取任何ptr指针的内容
    unsafe fn drop_this(&self, ptr: *const ()) {
        unsafe { (self.fn_ptr_drop)(ptr) }
    }
#
#    fn is_same_type<T>(&self) -> bool {
#        self.ty_name == type_name::<T>()
#    }
}
```

最后，调整 `Drop` 的实现，在释放堆空间之前析构动态派发的对象。

> 由于 ZST 类型从指针读取实际只要指针非空就能读取，所以 drop 时可以不区分 ZST

```rust
#pub struct DynDispatch {
#    raw: NonNull<()>,
#    vtb: Box<VirtualTable>,
#}
#
impl Drop for DynDispatch {
    fn drop(&mut self) {
        unsafe{ self.vtb.drop_this(self.raw.as_ptr()); }
        if !self.vtb.is_zst {
            unsafe { dealloc(self.raw.as_ptr() as *mut _, self.vtb.layout) }
        }
    }
}
```

## Oops! Undefine Behaver

接下来我们准备另一个测试用例

```rust
fn main(){
    let data = DynDispatch::new((&b"key003"[..], b"value003".to_vec()));

    assert_eq!(data.key(), b"key003");
    assert_eq!(data.value(), b"value003");

    let (_, v) = data
        .try_cast_owned::<(&'static [u8], Vec<u8>)>()
        .unwrap();

    assert_eq!(v, b"value003");
}
```

我们成功得到一个 ub 错误， use after free

```shell
error: Undefined Behavior: pointer to alloc3358 was dereferenced after this allocation got freed
```

究其原因，就是在 `try_cast_owned` 中内存释放中存在问题, 在这个函数中，当函数返回时， self 析构了，并调用 `Drop::drop`
将堆上动态分发的原始对象完全地析构了，这使得返回的 T 内的资源或者指针全部指向已经释放的内存空间。

解决方法也不算复杂，可以添加一个标记 `take_away` 来标记动态派发的对象是否已经被取走了，如果已经取走了，那可以不析构对象而只需要将 raw 指向的内存空间清理了就行。
我将这个 `take_away` 放在 vtb 中

首先，调整 `VirtualTable` 添加 `take_away`

```rust
struct VirtualTable {
    take_away: bool,
#    //ty
#    ty_name: &'static str,
#    // mem
#    is_zst: bool,
#    layout: Layout,
#    // vtb
#    fn_ptr_key: unsafe fn(*const ()) -> *const [u8],
#    fn_ptr_value: unsafe fn(*const ()) -> *const [u8],
#    fn_ptr_drop: unsafe fn(*const ()),
}

impl VirtualTable {
#    fn new<T: DataEntryRaw>() -> Self {
#        Self {
#            take_away: false,
#            ty_name: type_name::<T>(),
#            is_zst: size_of::<T>() == 0,
#            layout: Layout::new::<T>(),
#            fn_ptr_key: <T as DataEntryRaw>::key,
#            fn_ptr_value: <T as DataEntryRaw>::value,
#            fn_ptr_drop: <T as DataEntryRaw>::drop,
#        }
#    }
#
#    fn call_key(&self, ptr: *const ()) -> &[u8] {
#        let ret: *const [u8] = unsafe { (self.fn_ptr_key)(ptr) };
#        unsafe { ret.as_ref() }.unwrap()
#    }
#
#    fn call_value(&self, ptr: *const ()) -> &[u8] {
#        let ret: *const [u8] = unsafe { (self.fn_ptr_value)(ptr) };
#        unsafe { ret.as_ref() }.unwrap()
#    }
#    /// # Safety
#    /// 该接口只在 drop 时使用一次
#    /// 使用该接口后不读取任何ptr指针的内容
#    unsafe fn drop_this(&self, ptr: *const ()) {
#        unsafe { (self.fn_ptr_drop)(ptr) }
#    }
#
#    fn is_same_type<T>(&self) -> bool {
#        self.ty_name == type_name::<T>()
#    }
#
    fn take(&mut self) {
        self.take_away = true;
    }
}
```

然后调整 `Drop` 实现，保证堆上的原始对象在没有被取走时才会执行析构

```rust
#pub struct DynDispatch {
#    raw: NonNull<()>,
#    vtb: Box<VirtualTable>,
#}
#
impl Drop for DynDispatch {
    fn drop(&mut self) {
        unsafe{ self.vtb.drop_this(self.raw.as_ptr()); }
        if !self.vtb.is_zst {
            unsafe { dealloc(self.raw.as_ptr() as *mut _, self.vtb.layout) }
        }
    }
}
```

最后调整 `try_cast_owned` ，如果成功取得，那就标记为 `take_away`

```rust
#pub struct DynDispatch {
#    raw: NonNull<()>,
#    vtb: Box<VirtualTable>,
#}
#
impl DynDispatch {
#    pub fn try_cast_ref<T>(&self) -> Option<&T> {
#        if self.vtb.is_same_type::<T>() {
#            Some(unsafe { (self.raw.as_ptr() as *mut () as *const T).as_ref() }.unwrap())
#        } else {
#            None
#        }
#    }
#
#    pub fn try_cast_mut<T>(&mut self) -> Option<&mut T> {
#        if self.vtb.is_same_type::<T>() {
#            Some(unsafe { (self.raw.as_ptr() as *mut T).as_mut() }.unwrap())
#        } else {
#            None
#        }
#    }
#
    pub fn try_cast_owned<T>(mut self) -> Option<T> {
        if self.vtb.is_same_type::<T>() {
            let data = unsafe { std::ptr::read(self.raw.as_ptr() as *const () as _) };
            self.vtb.take();
            Some(data)
        } else {
            None
        }
    }
}
```

经过以上调整，就能正确释放内存了

## 总结

动态分发手动实现还是略微有些复杂的，并且较多地涉及到 unsafe 的代码相对有更高的心智负担。如果要手动实现动态派发，需要注意以下几点

1. 传递的对象可能是 ZST, [`alloc`](https://doc.rust-lang.org/stable/std/alloc/fn.alloc.html) 如果传递一个 0 大小的 [`Layout`](https://doc.rust-lang.org/stable/std/alloc/struct.Layout.html) 将会是未定义行为
2. 析构时需要 [`Layout`](https://doc.rust-lang.org/stable/std/alloc/struct.Layout.html), 但是由于抹除了类型，所以需要在 new 时就记录以在析构时使用
3. 虚表中需要记录 `drop` 函数指针，以能够在析构时能正确释放动态派发的对象的内存
4. `try_cast_owned` 中注意要正确释放内存

所有的代码可以在 [playgound](https://play.rust-lang.org/?version=stable&mode=debug&edition=2021&gist=b8675fcd06a3e955cc0b17012ab64e11) 中找到

---

作者亦为 Rust 新手，如有错漏，可以通过本 blog 相关的[github](https://github.com/Goodjooy/mdbook_blog/issues)项目发起 issue
转载请标记出处
