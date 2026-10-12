export interface CategoryDefinition {
  slug: string;
  name: string;
  title: string;
  description: string;
  intro: string;
  tags: string[];
}

export const CATEGORIES: readonly CategoryDefinition[] = [
  {
    slug: 'phim',
    name: 'Phim',
    title: 'Phim ngắn, phim độc lập và phim do cộng đồng chia sẻ',
    description:
      'Khám phá các bộ phim ngắn, phim lẻ và tác phẩm độc lập do cộng đồng nhà sáng tạo chia sẻ trên Winkey. Thưởng thức nội dung phong phú và ủng hộ tác giả.',
    intro:
      'Chào mừng bạn đến với chuyên mục Phim trên Winkey. Nơi tổng hợp các bộ phim ngắn, phim tài liệu và dự án điện ảnh độc lập do cộng đồng nhà sáng tạo chia sẻ. Hãy cùng theo dõi và ủng hộ những câu chuyện sáng tạo từ các tác giả.',
    tags: ['phim', 'phim-le', 'phim-hay', 'co-trang', 'hanh-dong', 'kinh-di', 'tinh-cam'],
  },
  {
    slug: 'phim-bo',
    name: 'Phim bộ',
    title: 'Tuyển tập phim bộ, web-series và phim dài tập tự sản xuất',
    description:
      'Xem tuyển tập phim bộ nhiều tập, web-series và câu chuyện dài kỳ do cộng đồng sáng tạo phát hành trên Winkey. Theo dõi trọn vẹn từng tập phim hấp dẫn.',
    intro:
      'Khám phá các chuỗi phim bộ nhiều tập và web-series thú vị do người dùng đăng tải trên Winkey. Theo dõi hành trình của từng nhân vật qua mỗi tập phim được cập nhật đều đặn. Thưởng thức những dự án phim dài kỳ giàu tâm huyết của cộng đồng.',
    tags: ['phim-bo', 'series'],
  },
  {
    slug: 'am-nhac',
    name: 'Âm nhạc',
    title: 'Video âm nhạc, bản cover và sáng tác do cộng đồng chia sẻ',
    description:
      'Lắng nghe các video ca nhạc, bản cover mộc mạc và sáng tác mới từ cộng đồng yêu âm nhạc trên Winkey. Khám phá những giai điệu trẻ trung đầy cảm xúc.',
    intro:
      'Không gian kết nối những giai điệu và tình yêu âm nhạc tại Winkey. Thưởng thức các sản phẩm âm nhạc độc lập, bản thu cover và giai điệu mộc mạc từ những người yêu ca hát. Cùng lan tỏa niềm đam mê sáng tạo âm nhạc mỗi ngày.',
    tags: ['am-nhac', 'nhac', 'music', 'nhac-tre', 'bolero', 'rap'],
  },
  {
    slug: 'game',
    name: 'Game',
    title: 'Highlights gameplay, hướng dẫn trò chơi và video gaming',
    description:
      'Theo dõi video highlights gaming, mẹo chơi bổ ích và khoảnh khắc ấn tượng từ cộng đồng game thủ trên Winkey. Cùng chia sẻ kinh nghiệm chơi game bổ ích.',
    intro:
      'Góc giao lưu và chia sẻ dành cho cộng đồng người chơi game trên Winkey. Xem các pha xử lý highlights, hướng dẫn vượt màn và mẹo chơi hay từ các game thủ. Tham gia thảo luận và chia sẻ hành trình trải nghiệm trò chơi của bạn.',
    tags: ['game', 'gaming', 'lien-quan', 'free-fire', 'minecraft'],
  },
  {
    slug: 'hai-huoc',
    name: 'Hài hước',
    title: 'Video hài hước, tiểu phẩm vui nhộn và khoảnh khắc đời thường',
    description:
      'Thư giãn với những video hài hước, tiểu phẩm vui vẻ và tình huống dí dỏm do thành viên chia sẻ trên Winkey. Nạp lại năng lượng tích cực mỗi ngày cùng bạn.',
    intro:
      'Nơi mang lại tiếng cười nhẹ nhàng và phút giây thư giãn trên Winkey. Tổng hợp những khoảnh khắc vui tươi, tiểu phẩm đời thường và tình huống dí dỏm do người dùng đóng góp. Đón nhận nguồn năng lượng tích cực sau những giờ học tập và làm việc.',
    tags: ['hai-huoc', 'hai', 'funny'],
  },
  {
    slug: 'giai-tri',
    name: 'Giải trí',
    title: 'Video giải trí tổng hợp, vlog đời sống và sáng tạo nội dung',
    description:
      'Khám phá video giải trí phong phú trên Winkey với vlog đời sống, câu chuyện thú vị và nội dung đời thường được chia sẻ bởi cộng đồng người dùng đa dạng.',
    intro:
      'Không gian giải trí tổng hợp đa sắc màu trên Winkey. Cùng xem các video vlog cuộc sống, trải nghiệm thú vị và nội dung sáng tạo do người dùng chia sẻ. Khám phá những góc nhìn mới mẻ và chân thực từ cuộc sống thường nhật.',
    tags: ['giai-tri', 'showbiz', 'talkshow'],
  },
  {
    slug: 'the-thao',
    name: 'Thể thao',
    title: 'Khoảnh khắc thể thao, tập luyện và vận động phong trào',
    description:
      'Xem video ghi lại khoảnh khắc thể thao phong trào, kỹ năng tập luyện và niềm vui vận động do người yêu thể thao chia sẻ trên nền tảng video Winkey.',
    intro:
      'Nơi hội tụ niềm yêu thích thể thao và rèn luyện thể chất trên Winkey. Theo dõi những pha bóng đẹp mắt từ các giải phong trào, bài tập rèn luyện sức khỏe và chia sẻ kinh nghiệm vận động. Lan tỏa tinh thần thể thao tích cực đến mọi người.',
    tags: ['the-thao', 'bong-da'],
  },
  {
    slug: 'hoat-hinh',
    name: 'Hoạt hình',
    title: 'Hoạt hình ngắn, diễn họa 2D và video sáng tạo độc lập',
    description:
      'Thưởng thức các tác phẩm hoạt hình ngắn, đồ họa chuyển động và video diễn họa do các họa sĩ trẻ tự do chia sẻ trên Winkey. Ủng hộ nội dung sáng tạo mới.',
    intro:
      'Góc trưng bày các tác phẩm hoạt hình ngắn và diễn họa do cộng đồng sáng tạo trên Winkey. Chiêm ngưỡng những nét vẽ độc đáo, hoạt họa mộc mạc và ý tưởng câu chuyện mới lạ. Cùng ủng hộ niềm đam mê của các nghệ sĩ diễn họa độc lập.',
    tags: ['hoat-hinh', 'anime'],
  },
];

export function getAllCategories(): CategoryDefinition[] {
  return [...CATEGORIES];
}

export function getCategory(slug: string): CategoryDefinition | undefined {
  return CATEGORIES.find((cat) => cat.slug === slug);
}

export function isCategorySlug(slug: string): boolean {
  return CATEGORIES.some((cat) => cat.slug === slug);
}
